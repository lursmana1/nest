import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExamsService } from './exams.service';
import { Exam } from './entities/exam.entity';
import { Question } from '../questions/entities/question.entity';

describe('ExamsService', () => {
  let service: ExamsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamsService,
        { provide: getRepositoryToken(Exam), useValue: {} },
        { provide: getRepositoryToken(Question), useValue: {} },
      ],
    }).compile();

    service = module.get<ExamsService>(ExamsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
